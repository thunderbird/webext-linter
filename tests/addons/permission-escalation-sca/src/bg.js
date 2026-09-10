// The readable review source, reviewed by the input:source code checks. NOTE:
// unused-permission is input:xpi, so it judges the SHIPPED build (xpi/background.js), NOT
// this file - the permission tokens that decide the verdicts live in the minified XPI, not
// here. This file only needs to be a valid source subtree for the SCA review to have a
// review target; its property reads mirror the shipped build's for readability.
function describe(msg, folder) {
  const rel = msg.relatedMessageId;
  const box = folder.displayedFolder;
  return { rel, box };
}
describe();
