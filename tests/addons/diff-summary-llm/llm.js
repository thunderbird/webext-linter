// LLM answers for the diff-summary-llm fixture (see tests/fake-llm.js). With --llm-review
// on (the presence of this file) AND a --diff-to baseline (its expected.json options), the
// review adds a "Summary of changes" - the one path driven by ctx.llm.summarize / callText.
//
//   text   -> the diff summary prose (ctx.llm.summarize, the "Summary of changes").
//   review -> the add-on summary (ctx.llm.reviewAddon) still runs; this add-on hands no
//             items to any recheck consumer, so its derived recheck list is empty.

export const text =
  "Summary of changes: background.js now logs a refreshed greeting; version bumped 1.0 -> 1.1.";

export const review = {
  summary: "A minimal add-on that logs a message when installed.",
};
