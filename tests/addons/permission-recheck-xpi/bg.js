// Live code that grounds each declared permission's usage token: relatedMessageId
// (messagesRead) and displayedFolder (accountsRead) are read as properties, and
// messenger.scripting.executeScript is a real injection CALL - compose's dotted token,
// resolved against the api-usage analysis (a bare identifier would not count). None is
// proven USED by the deterministic scan (property reads need no permission; the
// injection's target tab kind is semantic), so each escalates to
// unused-permission-recheck for the --llm-review pass to judge per occurrence.
// (scripting.executeScript grounds "scripting" itself, which is declared, so scripting
// is dropped deterministically and never reaches the recheck.)
function describe(msg, folder, details) {
  const rel = msg.relatedMessageId;
  const box = folder.displayedFolder;
  messenger.scripting.executeScript(details);
  return { rel, box };
}
describe();
