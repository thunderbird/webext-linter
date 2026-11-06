// ISSUING A PROMPT: the two acts every prompt of a review goes out by, each coded once.
//
// "issue a hand-back prompt" writes the record, then the answers file the agent fills in,
// then prints the prompt, so a prompt never names a file that is not written yet. It issues
// unpack, analyze and every later build check step, every phase of the review loop and the
// restart prompt. "issue the closing prompt" writes report.md and the record at the close,
// then prints the verdicts applied and the closing prompt.
//
// Both print with writeToStdout: a prompt is a whole document. What differs stays with the
// caller: it builds the record and the lines, writes report.md first where a hand-back prompt
// needs it, and hands the exit code to exit handling after the call.
//
// Belongs here: the order of the writes and the print. Does NOT belong here: what the record
// holds (src/review/record.js), what a prompt says (src/report/format.js and the registry), or
// which prompt goes out (src/report/loop.js, src/build-check/steps.js, src/cli.js).

import { writeRecord } from "./record.js";
import { reviewFile, writeReviewFile } from "../report/handback.js";
import { writeReportFile } from "../report/report-file.js";
import { workPaths } from "../util/dest.js";
import { writeToStdout } from "../util/log.js";

/**
 * Print a prompt's lines, and the blank line that ends it.
 * @param {string[]} lines
 */
function printPrompt(lines) {
  for (const line of lines) {
    writeToStdout(`${line}\n`);
  }
  writeToStdout("\n");
}

/**
 * Issue a hand-back prompt: the record written (atomic), then the answers file with the
 * entries the agent answers - none where the step asks nothing - then the prompt printed.
 * @param {string} work  The work folder.
 * @param {object} record  At the step or phase the prompt is for.
 * @param {object[]} entries  What the agent answers.
 * @param {string[]} lines  The prompt.
 * @returns {object}  The record as written.
 */
export function issueHandbackPrompt(work, record, entries, lines) {
  const written = writeRecord(work, record);
  writeReviewFile(workPaths(work).answers, reviewFile(entries));
  printPrompt(lines);
  return written;
}

/**
 * Issue the closing prompt: report.md written from the settled review at its fixed path, the
 * record written at
 * the close (atomic), so every later hand-back is refused, then what the verdicts did - this
 * tool's note to whoever ran the command, printed before the prompt so it cannot be copied
 * along with it - and the closing prompt printed.
 * @param {string} work  The work folder.
 * @param {import("./settle.js").SettledReview} settled
 * @param {object} record  In mode review, at the close.
 * @param {string[]} lines  The closing prompt.
 * @returns {object}  The record as written.
 */
export function issueClosingPrompt(work, settled, record, lines) {
  writeReportFile(workPaths(work).report, settled.report);
  const written = writeRecord(work, record);
  if (settled.applied.length) {
    writeToStdout(
      `Applied ${settled.applied.length} verdict(s): ${settled.applied.join(", ")}\n\n`
    );
  }
  printPrompt(lines);
  return written;
}
