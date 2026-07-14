// Source that spells each declared permission's usage token in live code, so in SCA
// mode every declared permission escalates to the unused-permission recheck, which the
// SOURCE summary pass re-judges with cited evidence - verified against THIS source
// (the recheck's producer corpus, resolved by ctxForRule).
function describe(msg, folder, tab) {
  const rel = msg.relatedMessageId;
  const box = folder.displayedFolder;
  const inject = tab.executeScript;
  return { rel, box, inject };
}
describe();
