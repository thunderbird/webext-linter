// The one review document this tool WRITES: the text the reviewer sends to the developer.
//
// The other two beside the submitted .xpi are written by sub-agents and only NAMED here
// (src/report/items.js reviewFilePaths). This one is not asked of anyone, because asking
// was what failed: the hand-over used to print the report into the chat and tell the model
// to reproduce it "in a code block and unchanged", and a model that rewords its input
// corrupts the one text a developer actually receives. A file the linter writes cannot be
// reworded.
//
// Written TWICE, because the reviewer reads it while they answer:
//  - before the Review Details block is handed over, so the link they are given already
//    opens something. That copy is the review as it stands, which is the review minus what
//    the questions have yet to produce - a question becomes a finding only once answered,
//    and the report body is findings alone.
//  - once those answers are in, rewritten from the settled review.
//
// Belongs here: turning a review into that file's bytes and putting them on disk. Does NOT
// belong here: deciding the path (-> src/report/items.js), when to call this (-> the two
// sites in src/report/loop.js), or what the report SAYS, which is the registry's wording
// rendered by src/report/format.js.

import { writeFileAtomic } from "../util/atomic.js";

/**
 * Write the developer-facing report to the path this review named, or do nothing when it
 * named none.
 *
 * Silent about a path it was not given: only a prompting run names one, and every other
 * run prints the report to stdout instead. Atomic, so a reviewer who opens the file while
 * a pass is rewriting it reads one version or the other and never half of each.
 * @param {?string} file  state.paths.report, or null.
 * @param {string} body  The report body, as settle() builds it.
 * @returns {void}
 */
export function writeReportFile(file, body) {
  if (!file) {
    return;
  }
  writeFileAtomic(file, `${body}\n`);
}
