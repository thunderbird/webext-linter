// Source that grounds each declared permission's usage token: relatedMessageId
// (messagesRead) and displayedFolder (accountsRead) are read as properties (bare tokens,
// found by the atom scan and judged per occurrence). compose's tokens are dotted
// (api-resolved) injection calls; in this SCA review the source is not the shipped
// entry point, so no injection call resolves here and compose has no located site - it
// is therefore judged HOLISTICALLY (one verdict over the whole source), which is the
// SCA-mode fallback the recheck must still handle. Every declared permission escalates
// in SCA (the deterministic scan cannot trust the source over the shipped build).
function describe(msg, folder) {
  const rel = msg.relatedMessageId;
  const box = folder.displayedFolder;
  return { rel, box };
}
describe();
