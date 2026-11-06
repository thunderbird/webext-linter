// The one review document this tool WRITES: the text the reviewer sends to the developer.
//
// The other two documents in the review's work folder, the summary report and the build
// report, are written by agents and only NAMED (src/util/dest.js workPaths). This one is asked of nobody: a model that rewords
// its input would corrupt the one text a developer actually receives, and a file the linter
// writes itself cannot be reworded.
//
// Written TWICE, because the reviewer reads it while they answer:
//  - before the Review Details block is handed over, so the link they are given already
//    opens something. That copy is the review as it stands, which is the review minus what
//    the questions have yet to produce - a question becomes a finding only once answered,
//    and the report body is findings alone.
//  - once those answers are in, rewritten from the settled review.
//
// Belongs here: turning a review into that file's bytes and putting them on disk. Does NOT
// belong here: deciding the path (-> src/util/dest.js workPaths), when to call this (-> the two
// sites in src/report/loop.js), or what the report SAYS, which is the registry's wording
// rendered by src/report/format.js.

import { writeFileAtomic } from "../util/atomic.js";
import { withoutColor } from "../util/color.js";

/**
 * Write the developer-facing report to review.md, at the work folder's fixed path. Only an
 * LLM review writes one, and every other run prints the report to stdout instead. Atomic, so
 * a reviewer who opens the file while a pass is rewriting it reads one version or the other
 * and never half of each.
 * @param {string} file  The work folder's review.md (src/util/dest.js workPaths).
 * @param {string} body  The report body, as settleReview builds it (src/review/settle.js).
 * @returns {void}
 */
export function writeReportFile(file, body) {
  // Rendered by the same formatter as the terminal report, so colour markers are removed:
  // a file carries none. The empty lines that separate it from a section heading in the
  // terminal have nothing to separate here, so the file starts and ends on its text.
  writeFileAtomic(file, `${withoutBlankEnds(withoutColor(body))}\n`);
}

/**
 * The text without empty lines at either end. Plain code rather than a regex: the body
 * carries submission text, and `\n+$` backtracks over every run of newlines inside it.
 * @param {string} text
 * @returns {string}
 */
function withoutBlankEnds(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "\n") {
    start++;
  }
  while (end > start && text[end - 1] === "\n") {
    end--;
  }
  return text.slice(start, end);
}
