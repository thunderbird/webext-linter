// Add-on test harness. Runs every sample add-on under tests/addons/ through the
// reviewer against the offline schema fixture and checks two things:
//   1. per-rule finding locations ("file:line") against each add-on's curated
//      expected.json (a human-readable spec of which rules fire where), and
//   2. the FULL rendered report (text + JSON) against a golden snapshot in
//      tests/golden/ (a byte-level regression lock for the orchestrator,
//      formatter and LLM plumbing - the layers thin unit tests barely cover).
// Exits non-zero on any mismatch. Regenerate goldens with UPDATE_GOLDEN=1.
//
//   node tests/run-tests.js
//   UPDATE_GOLDEN=1 node tests/run-tests.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPipeline } from "../src/pipeline.js";
import { pipelineOptsFromArgv } from "../src/cli.js";
import { loadAddon } from "../src/addon/load.js";
import { formatReview } from "../src/report/format.js";
import { fixtureCacheOpts } from "./seed-caches.js";
import { makeFakeTransport } from "./fake-llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
// A cache pre-seeded from the fixtures, so the pipeline's schema / experiments /
// library-hash fetches all hit disk - the whole harness runs offline.
const CACHE_OPTS = fixtureCacheOpts();
const ADDONS_DIR = path.join(here, "addons");
const GOLDEN_DIR = path.join(here, "golden");
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

// Vendor verification is the only networked stage. Inject a transport that
// refuses every request so the golden harness never touches the real network: a
// fetchable declaration deterministically becomes "unfetchable" -> manual review.
const OFFLINE_NET = {
  fetchBytes: async () => {
    throw new Error("offline");
  },
  fetchJson: async () => {
    throw new Error("offline");
  },
};

// Each fixture's expected.json holds the expected per-rule locations under
// "expect", and may carry an optional "options" object keyed by real CLI flags
// (e.g. { "--allow-experiments": true }), so a fixture can exercise a flag-gated
// check through the same parsing the CLI uses.
function loadFixture(dir) {
  const file = path.join(dir, "expected.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return { expect: parsed.expect ?? {}, options: parsed.options ?? {} };
}

// A fixture is an SCA (source-code archive) review when it holds two artifacts as
// subfolders: `xpi/` (the shipped built add-on, the authoritative manifest) and
// `src/` (the readable source tree the code checks review, e.g. a Vue .vue file).
// The harness then drives runPipeline in SCA mode; a plain fixture folder is an
// ordinary XPI review. Detected by layout, so expected.json needs no extra flag.
function isScaFixture(dir) {
  return ["xpi", "src"].every(
    (sub) =>
      fs.existsSync(path.join(dir, sub)) &&
      fs.statSync(path.join(dir, sub)).isDirectory()
  );
}

// A fixture opts into --llm-review coverage by shipping an `llm.js` beside its
// expected.json: the module declares the model's canned answers (see tests/fake-llm.js),
// which become a deterministic, offline llmTransport. Its presence is the switch - the
// harness then turns --llm-review on with a dummy claude key (no network probe, so
// llmVerified goes true offline) and injects the transport. Fixtures without it review
// offline as usual. Returns the transport, or null when absent.
async function loadLlmTransport(dir) {
  const file = path.join(dir, "llm.js");
  if (!fs.existsSync(file)) {
    return null;
  }
  const mod = await import(pathToFileURL(file).href);
  return makeFakeTransport(mod.default ?? mod);
}

// Turn a fixture's flag-keyed "options" object into a CLI argv: a `true` value
// is a bare boolean flag, anything else becomes `--flag <value>`.
function optionsToArgv(options) {
  const argv = [];
  for (const [flag, value] of Object.entries(options)) {
    if (value === true) {
      argv.push(flag);
    } else if (value != null && value !== false) {
      argv.push(flag, String(value));
    }
  }
  return argv;
}

// Per-rule sorted list of "file:line" locations (or "(add-on)" for a finding
// with no file, "file" when a finding has no line). Rules with no findings are
// omitted. The list length is the hit count; the entries say where.
function locationsByRule(findings) {
  const byRule = {};
  for (const f of findings) {
    const where = f.file
      ? `${f.file}${f.loc?.line != null ? `:${f.loc.line}` : ""}`
      : "(add-on)";
    (byRule[f.ruleId] ??= []).push(where);
  }
  for (const key of Object.keys(byRule)) {
    byRule[key].sort();
  }
  return byRule;
}

// Compare actual vs expected per-rule location lists. Order-insensitive
// (both sorted), duplicates significant. A rule absent on one side is an empty
// list there.
function diff(expected, actual) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  const problems = [];
  for (const key of keys.sort()) {
    const e = [...(expected[key] ?? [])].sort();
    const a = actual[key] ?? [];
    if (e.length !== a.length || e.some((v, i) => v !== a[i])) {
      problems.push(
        `${key}: expected [${e.join(", ")}], got [${a.join(", ")}]`
      );
    }
  }
  return problems;
}

// Replace the repo's absolute path so goldens are machine-independent (the
// add-on path and schema source both embed it).
function normalize(text) {
  return text.split(ROOT).join("<root>");
}

// First differing line between two multi-line strings, for a concise report.
function firstDiff(a, b) {
  const as = a.split("\n");
  const bs = b.split("\n");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) {
      return `line ${i + 1}: golden ${JSON.stringify(as[i])} != got ${JSON.stringify(bs[i])}`;
    }
  }
  return "differ";
}

// Compare a rendered report against its golden, or (re)write it. Returns a
// problem string, or "" when it matches / was written.
function checkGolden(name, ext, content) {
  const file = path.join(GOLDEN_DIR, `${name}.${ext}`);
  if (UPDATE_GOLDEN || !fs.existsSync(file)) {
    fs.writeFileSync(file, content);
    return "";
  }
  const golden = fs.readFileSync(file, "utf8");
  return golden === content
    ? ""
    : `golden ${ext}: ${firstDiff(golden, content)}`;
}

async function main() {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const addons = fs
    .readdirSync(ADDONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  let failed = 0;
  for (const name of addons) {
    const dir = path.join(ADDONS_DIR, name);
    const { expect: expected, options } = loadFixture(dir);
    let problems;
    try {
      // Pure schema review: no pretty-print, no packing — keeps lines stable.
      // A fixture's flag "options" parse in first; the core review opts win. The
      // CDN identifier is a networked step that cannot match offline; turn it off
      // so golden runs are hermetic (no per-run cache file written).
      const llmTransport = await loadLlmTransport(dir);
      const base = {
        ...pipelineOptsFromArgv(optionsToArgv(options)),
        ...CACHE_OPTS,
        vendorNet: OFFLINE_NET,
        cdnLookup: false,
        // An llm.js fixture turns --llm-review on with a dummy claude key (validateLlmConfig
        // passes, checkModelAvailable makes no probe) and the deterministic fake transport,
        // so the LLM paths run fully offline. Undefined llmTransport leaves the run offline.
        ...(llmTransport
          ? {
              llmReview: true,
              llmApiType: "claude",
              llmApiKey: "test",
              llmModel: "test",
              llmTransport,
            }
          : {}),
      };
      let review;
      if (isScaFixture(dir)) {
        // SCA mode: the shipped XPI is the authoritative artifact (addonPath), the
        // src/ tree is the review target (scaRoot, flat so scaSource is ".").
        review = await runPipeline({
          ...base,
          addonPath: path.join(dir, "xpi"),
          scaRoot: path.join(dir, "src"),
          scaSource: ".",
        });
      } else {
        // XPI mode: load the add-on ourselves and drop the expected.json sidecar so
        // it is not seen as an (unused) add-on file by the review.
        const addon = loadAddon(dir);
        // Drop the harness sidecars so they are not reviewed as add-on files: the
        // expected.json spec and, for an LLM fixture, its llm.js answer module.
        addon.files.delete("expected.json");
        addon.files.delete("llm.js");
        review = await runPipeline({ ...base, addon });
      }
      problems = diff(expected, locationsByRule(review.findings));
      for (const [ext, fmt] of [
        ["txt", "text"],
        ["json", "json"],
      ]) {
        // formatReview is the single source of the shipped report: for text it already
        // includes the advisory LLM summaries in position (before the tally), the same
        // string the CLI writes - so an LLM fixture's golden locks its summary prose too.
        const body = formatReview(review, fmt);
        const p = checkGolden(name, ext, normalize(body));
        if (p) {
          problems.push(p);
        }
      }
    } catch (err) {
      console.error(`✗ ${name}: threw ${err.message}`);
      failed++;
      continue;
    }
    if (problems.length === 0) {
      console.log(`✓ ${name}`);
    } else {
      console.error(`✗ ${name}\n    ${problems.join("\n    ")}`);
      failed++;
    }
  }

  console.log("");
  if (failed === 0) {
    console.log(
      `All ${addons.length} add-on(s) passed.` +
        (UPDATE_GOLDEN ? " (goldens regenerated)" : "")
    );
  } else {
    console.error(`${failed} of ${addons.length} add-on(s) failed.`);
    process.exitCode = 1;
  }
}

main();
