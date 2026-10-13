// Compares where a hot run stopped with its case (tests/hot/README.md):
//
//   node tests/hot/check.js <case id> <work folder>
//
// Reads only the linter's own files in the work folder, through the readers the linter
// uses itself: the review's state at the Build Review Details (row 14), or the settled
// review of an aborted one, and that the rescued copy, where there is one, holds no
// node_modules/: nothing is ever installed or built in it. Prints each difference and exits 1
// on a mismatch, 0 on a match, 2 when it cannot read the case or the folder. Asserts
// outcomes, never package versions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRegistry } from "../../src/checks/registry.js";
import { readPrepare } from "../../src/prepare/state.js";
import { buildResultFact, settle } from "../../src/report/loop.js";
import { readState } from "../../src/report/state.js";
import { workPaths } from "../../src/util/dest.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The top folder of the work folder a path lies in (`sca`, `rescued`, `build`), or null
 * where it lies outside the work folder or there is no path.
 * @param {string} work  The work folder, real.
 * @param {?string} target
 * @returns {?string}
 */
function areaOf(work, target) {
  if (!target) {
    return null;
  }
  const rel = path.relative(work, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep)[0];
}

/**
 * Every node_modules/ folder inside `folder`, links not followed, relative to it.
 * @param {string} folder
 * @returns {string[]}
 */
function installedIn(folder) {
  if (!fs.existsSync(folder)) {
    return [];
  }
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const at = path.join(dir, entry.name);
      if (entry.name === "node_modules") {
        found.push(path.relative(folder, at));
      } else {
        walk(at);
      }
    }
  };
  walk(folder);
  return found;
}

/**
 * Where the run stopped, as the values a case names.
 * @param {string} work  The work folder, real.
 * @returns {object}
 */
function stopOf(work) {
  const paths = workPaths(work);
  if (!fs.existsSync(paths.state)) {
    const record = readPrepare(work);
    return {
      stop: record ? `preparation at ${record.step}` : "no review",
    };
  }
  const state = readState(paths.state);
  // The band policy is the review's own, as every hand-back reads it.
  const registry = loadRegistry().withPolicy({
    warningsAsErrors: state.run.warningsAsErrors,
  });
  if (state.phase === "build-result") {
    const counts = state.build?.vulnerabilities ?? null;
    return {
      stop: "row-14",
      BUILD_SAFETY: state.values?.["build-safety"] ?? null,
      BUILD_VULNERABILITIES: counts,
      BUILD_RESULT:
        registry.llmPhases().buildResults[buildResultFact(state)] ?? null,
      BUILD_OUTPUT: state.build?.output
        ? areaOf(work, state.build.output)
        : false,
      SCA_ROOT: areaOf(work, state.paths?.scaRoot ?? null),
    };
  }
  if (state.phase === "close") {
    const settled = settle(structuredClone(state), registry);
    const earlyExit = settled.review.meta.earlyExit;
    if (!earlyExit) {
      return { stop: "close, not aborted" };
    }
    return {
      stop: "abort",
      reasons: earlyExit.reasons.map((r) => r.id),
      findings: settled.review.findings
        .filter((f) => f.severity === "error")
        .map((f) => f.ruleId),
    };
  }
  return { stop: `phase ${state.phase}` };
}

/**
 * Every difference between the case's expectation and the stop, one line each.
 * @param {object} expect
 * @param {object} got
 * @returns {string[]}
 */
function differences(expect, got) {
  const show = (v) => JSON.stringify(v);
  if (expect.stop !== got.stop) {
    return [`stop: expected ${show(expect.stop)}, got ${show(got.stop)}`];
  }
  const out = [];
  for (const [key, want] of Object.entries(expect)) {
    if (key === "stop") {
      continue;
    }
    const have = got[key];
    if (key === "BUILD_VULNERABILITIES") {
      // Only the severities the case names: the rest move with what OSV publishes.
      for (const [severity, n] of Object.entries(want)) {
        if (have?.[severity] !== n) {
          out.push(
            `${key}.${severity}: expected ${n}, got ${show(have?.[severity] ?? null)}`
          );
        }
      }
    } else if (key === "reasons") {
      const a = [...want].sort();
      const b = [...(have ?? [])].sort();
      if (show(a) !== show(b)) {
        out.push(`${key}: expected ${show(a)}, got ${show(b)}`);
      }
    } else if (key === "findings") {
      for (const id of want) {
        if (!(have ?? []).includes(id)) {
          out.push(`${key}: expected ${show(id)}, got ${show(have ?? [])}`);
        }
      }
    } else if (show(want) !== show(have ?? null)) {
      out.push(`${key}: expected ${show(want)}, got ${show(have ?? null)}`);
    }
  }
  return out;
}

function main(argv) {
  const [id, folder] = argv;
  if (!id || !folder) {
    process.stderr.write(
      "usage: node tests/hot/check.js <case id> <work folder>\n"
    );
    return 2;
  }
  const { cases } = JSON.parse(
    fs.readFileSync(path.join(here, "cases.json"), "utf8")
  );
  const hot = cases.find((c) => c.id === id);
  if (!hot) {
    process.stderr.write(`no case "${id}" in tests/hot/cases.json\n`);
    return 2;
  }
  let got;
  try {
    got = stopOf(fs.realpathSync(folder));
  } catch (err) {
    process.stderr.write(`${folder}: ${err.message}\n`);
    return 2;
  }
  const diff = [
    ...differences(hot.expect, got),
    ...installedIn(workPaths(fs.realpathSync(folder)).rescued).map(
      (at) => `rescued/ holds ${at}: nothing is installed in the rescued copy`
    ),
  ];
  if (diff.length) {
    process.stdout.write(
      `${id}: MISMATCH\n${diff.map((d) => `  ${d}\n`).join("")}`
    );
    return 1;
  }
  process.stdout.write(`${id}: match (${got.stop})\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
