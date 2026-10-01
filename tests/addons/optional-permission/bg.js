// Uses messagesRead. "messagesMove" is declared OPTIONAL and never used: optional
// permissions are judged like required ones, so it is reported as possibly unused.
async function run(folder) {
  await browser.messages.list(folder);
}
