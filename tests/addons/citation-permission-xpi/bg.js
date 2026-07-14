// Live-code reads that spell each permission's usage token (relatedMessageId /
// displayedFolder / executeScript), so none is deterministically unused - but no
// browser API call grounds them, so each escalates to unused-permission-recheck for
// the --llm-review pass to re-judge with cited evidence.
function describe(msg, folder, tab) {
  const rel = msg.relatedMessageId;
  const box = folder.displayedFolder;
  const inject = tab.executeScript;
  return { rel, box, inject };
}
describe();
