// Compares where a hot run stopped with its case (tests/hot/README.md):
//
//   node tests/hot/check.js <case id> <work folder>
//
// Reads only the linter's own files in the work folder, through the readers the linter
// uses itself: the review's state at the Build Review Details (row 14), or the settled
// review of an aborted one (at its close or its downgrade question), and that the rescued copy, where there is one, holds no
// node_modules/: nothing is ever installed or built in it. Prints each difference and exits 1
// on a mismatch, 0 on a match, 2 when it cannot read the case or the folder. Asserts
// outcomes, never package versions. LLM_BUILD_XPI_MATCH is printed and never compared: a case's lock
// is newer than the one its XPI was built from.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRegistry } from "../../src/checks/registry.js";
import { buildResultFact } from "../../src/report/loop.js";
import { MODE, modeOf, readRecord } from "../../src/review/record.js";
import { settleReview } from "../../src/review/settle.js";
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
 * The review a record holds, where it stands: mode review's own part while the loop runs, and
 * once the review ended the review its permanent part holds, at the phase or step the
 * current part stands at.
 * @param {object} record
 * @returns {object}
 */
function reviewOf(record) {
  return record.current?.report
    ? record.current
    : {
        ...record.review,
        phase: record.current?.phase ?? record.current?.step,
      };
}

/**
 * Where the run stopped, as the values a case names.
 * @param {string} work  The work folder, real.
 * @returns {object}
 */
function stopOf(work) {
  if (!fs.existsSync(workPaths(work).state)) {
    return { stop: "no review" };
  }
  const record = readRecord(work);
  const mode = modeOf(record);
  if (mode === MODE.experimentFolder || mode === MODE.buildCheck) {
    return { stop: `${mode} at ${record.current.step}` };
  }
  if (mode === undefined) {
    return { stop: "no review in progress" };
  }
  // Once the review ended, at the close or at the downgrade question, the record's permanent
  // part holds the review, and the current part where it stands.
  const downgrade = mode === MODE.downgrade;
  const state = reviewOf(record);
  // The build results a build check done first added to the record's permanent part.
  const build = record.build;
  // The band policy is the review's own, as every hand-back reads it.
  const registry = loadRegistry().withPolicy({
    warningsAsErrors: record.flags?.["warnings-as-errors"] === true,
  });
  // The rows both stops show: the counts, and the wording of what came of the agent's build.
  const shown = {
    SCA_VULNERABILITIES:
      build?.vulnerabilities ?? state.vulnerabilities ?? null,
    LLM_RESCUED_VULNERABILITIES: build?.rescuedVulnerabilities ?? null,
    LLM_BUILD_RESULT:
      registry.llmPhases().buildResults[buildResultFact(record)] ?? null,
  };
  if (state.phase === "built") {
    return {
      stop: "row-14",
      SCA_BUILD_SAFETY_ASSESSMENT: build?.safety ?? null,
      ...shown,
      LLM_BUILD_OUTPUT: build?.output ? areaOf(work, build.output) : false,
      LLM_BUILD_XPI_MATCH: build?.match ?? null,
      SCA_RESCUED: state.roots?.used !== state.roots?.source,
    };
  }
  // The closing prompt and the downgrade question both hand over the settled review, and
  // its abort reasons are read the same way at either.
  if (state.phase === "close" || downgrade) {
    const settled = settleReview(state, state.answers ?? {}, registry);
    const earlyExit = settled.exits.late;
    if (!earlyExit) {
      return { stop: `${downgrade ? "downgrade" : "close"}, not aborted` };
    }
    return {
      stop: downgrade ? "downgrade" : "abort",
      ...shown,
      reasons: earlyExit.reasons.map((r) => r.id),
      findings: settled.findings
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
    if (
      key === "SCA_VULNERABILITIES" ||
      key === "LLM_RESCUED_VULNERABILITIES"
    ) {
      // Only the severities the case names: the rest move with what OSV publishes. A count
      // is exact, or `{ "atLeast": n }` where the case pins only a floor.
      for (const [severity, n] of Object.entries(want)) {
        const got = have?.[severity];
        const holds =
          typeof n === "number"
            ? got === n
            : Number.isInteger(got) && got >= n.atLeast;
        if (!holds) {
          out.push(
            `${key}.${severity}: expected ${show(n)}, got ${show(got ?? null)}`
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
  // Reported beside the outcome, and never compared (differences reads only what a case
  // names, and no case names it).
  const reported = got.LLM_BUILD_XPI_MATCH
    ? `  LLM_BUILD_XPI_MATCH: ${got.LLM_BUILD_XPI_MATCH} (reported, not compared)\n`
    : "";
  const diff = [
    ...differences(hot.expect, got),
    ...installedIn(workPaths(fs.realpathSync(folder)).rescued).map(
      (at) => `rescued/ holds ${at}: nothing is installed in the rescued copy`
    ),
  ];
  if (diff.length) {
    process.stdout.write(
      `${id}: MISMATCH\n${diff.map((d) => `  ${d}\n`).join("")}${reported}`
    );
    return 1;
  }
  process.stdout.write(`${id}: match (${got.stop})\n${reported}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
