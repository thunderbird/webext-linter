// Readable, non-minified authored code: hasUnreviewableCode is false, so the
// review stays an SCA review and only sets scaNotRequired
// (see resolveXpiOnlyAdvice in src/pipeline.js).
async function run(folder) {
  const result = await browser.messages.list(folder);
  await messenger.messages.move([result.messages[0].id], folder);
  browser.messages.onNewMailReceived.addListener(() => {});
}
