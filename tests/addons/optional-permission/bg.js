// Uses messagesRead. "messagesMove" is declared as an OPTIONAL permission
// (granted at runtime), so it must NOT be reported as declared-but-unused.
async function run(folder) {
  await browser.messages.list(folder);
}
